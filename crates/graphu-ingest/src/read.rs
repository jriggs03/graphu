//! Step 1 of ingest: work out what kind of file this is and read whatever text can be read
//! without AI. Photos, scans and audio have no text to read here; they go on to transcription.

use std::io::Read;

/// What an uploaded file is, judged from its first bytes and, failing that, its name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Pdf,
    /// Plain text, Markdown, and similar.
    Text,
    /// PowerPoint slides (.pptx).
    Slides,
    /// A Word document (.docx).
    Word,
    /// A photo or scan. The value is the media type Claude expects, e.g. `image/png`.
    Image(&'static str),
    /// A photo format Claude cannot read (HEIC, TIFF, BMP).
    OtherImage,
    Audio,
    Unknown,
}

fn extension(name: &str) -> String {
    name.rsplit('.').next().unwrap_or("").to_lowercase()
}

pub fn classify(name: &str, bytes: &[u8]) -> Kind {
    let ext = extension(name);
    let starts = |prefix: &[u8]| bytes.starts_with(prefix);
    let at = |offset: usize, tag: &[u8]| bytes.len() >= offset + tag.len() && &bytes[offset..offset + tag.len()] == tag;
    if starts(b"%PDF-") {
        return Kind::Pdf;
    }
    if starts(b"\x89PNG") {
        return Kind::Image("image/png");
    }
    if starts(b"\xFF\xD8\xFF") {
        return Kind::Image("image/jpeg");
    }
    if starts(b"GIF8") {
        return Kind::Image("image/gif");
    }
    if starts(b"RIFF") && at(8, b"WEBP") {
        return Kind::Image("image/webp");
    }
    if starts(b"RIFF") && at(8, b"WAVE") || starts(b"ID3") || starts(b"OggS") || starts(b"fLaC") {
        return Kind::Audio;
    }
    if at(4, b"ftyp") {
        // The same container holds iPhone photos (HEIC) and voice memos (M4A).
        return if at(8, b"heic") || at(8, b"heix") || at(8, b"mif1") || at(8, b"avif") { Kind::OtherImage } else { Kind::Audio };
    }
    if starts(b"PK\x03\x04") {
        return match ext.as_str() {
            "pptx" => Kind::Slides,
            "docx" => Kind::Word,
            _ => Kind::Unknown,
        };
    }
    match ext.as_str() {
        "mp3" | "m4a" | "wav" | "aac" | "ogg" | "oga" | "opus" | "flac" | "webm" | "mp4" | "mov" | "aiff" | "caf" => Kind::Audio,
        "heic" | "heif" | "tif" | "tiff" | "bmp" => Kind::OtherImage,
        // Anything else counts as text if it is valid UTF-8 with no NUL bytes.
        _ if !bytes.contains(&0) && std::str::from_utf8(bytes).is_ok() => Kind::Text,
        _ => Kind::Unknown,
    }
}

/// Split plain text into "pages": at form feeds if the file has them, otherwise into
/// chunks of roughly a slide's worth so a citation can point at a part of the file.
pub fn text_pages(text: &str) -> Vec<String> {
    const TARGET: usize = 2500;
    let text = text.replace("\r\n", "\n");
    let parts: Vec<&str> = if text.contains('\u{c}') { text.split('\u{c}').collect() } else { vec![&text] };
    let mut pages = Vec::new();
    for part in parts {
        let mut page = String::new();
        for paragraph in part.split("\n\n") {
            if !page.is_empty() && page.len() + paragraph.len() > TARGET {
                pages.push(std::mem::take(&mut page));
            }
            if !page.is_empty() {
                page.push_str("\n\n");
            }
            page.push_str(paragraph);
        }
        pages.push(page);
    }
    pages.into_iter().map(|page| page.trim().to_string()).filter(|page| !page.is_empty()).collect()
}

/// Text of each page of a PDF. A scanned PDF comes back with empty pages.
pub fn pdf_pages(bytes: &[u8]) -> Result<Vec<String>, String> {
    // The PDF library can panic on unusual files, so contain it.
    let pages = std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem_by_pages(bytes))
        .map_err(|_| "This PDF could not be read.".to_string())?
        .map_err(|_| "This PDF could not be read. Encrypted PDFs are not supported.".to_string())?;
    Ok(pages.iter().map(|page| plain_letters(page)).collect())
}

/// Slides often store "fi" or "ff" as one joined character. Spell them out, so that a search
/// for "different" finds "diﬀerent" and a quote typed with plain letters matches the page.
///
/// in:  "Classiﬁcation with diﬀerent heads"      out: "Classification with different heads"
pub fn plain_letters(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for letter in text.chars() {
        match letter {
            'ﬀ' => out.push_str("ff"),
            'ﬁ' => out.push_str("fi"),
            'ﬂ' => out.push_str("fl"),
            'ﬃ' => out.push_str("ffi"),
            'ﬄ' => out.push_str("ffl"),
            'ﬅ' | 'ﬆ' => out.push_str("st"),
            other => out.push(other),
        }
    }
    out
}

fn unescape(text: &str) -> String {
    text.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

/// Collect the text inside every `<tag>…</tag>` run, putting a line break after each `</paragraph>`.
fn xml_text(xml: &str, tag: &str, paragraph: &str) -> String {
    let (open, open_attrs, close) = (format!("<{tag}>"), format!("<{tag} "), format!("</{tag}>"));
    let end_paragraph = format!("</{paragraph}>");
    let mut out = String::new();
    let mut rest = xml;
    loop {
        let next_text = [rest.find(&open), rest.find(&open_attrs)].into_iter().flatten().min();
        let next_break = rest.find(&end_paragraph);
        match (next_text, next_break) {
            (Some(text_at), line_at) if line_at.is_none_or(|line| text_at < line) => {
                let Some(start) = rest[text_at..].find('>').map(|i| text_at + i + 1) else { break };
                let Some(end) = rest[start..].find(&close).map(|i| start + i) else { break };
                out.push_str(&unescape(&rest[start..end]));
                rest = &rest[end + close.len()..];
            }
            (_, Some(line_at)) => {
                out.push('\n');
                rest = &rest[line_at + end_paragraph.len()..];
            }
            _ => break,
        }
    }
    out
}

fn zip_entry(archive: &mut zip::ZipArchive<std::io::Cursor<&[u8]>>, name: &str) -> Option<String> {
    let mut file = archive.by_name(name).ok()?;
    let mut text = String::new();
    file.read_to_string(&mut text).ok()?;
    Some(text)
}

/// One page of text per slide of a .pptx.
pub fn slides_pages(bytes: &[u8]) -> Result<Vec<String>, String> {
    let unreadable = || "This PowerPoint file could not be read.".to_string();
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|_| unreadable())?;
    let mut pages = Vec::new();
    for number in 1..=500 {
        let Some(xml) = zip_entry(&mut archive, &format!("ppt/slides/slide{number}.xml")) else { break };
        pages.push(xml_text(&xml, "a:t", "a:p"));
    }
    if pages.is_empty() { Err(unreadable()) } else { Ok(pages) }
}

/// The text of a .docx, split into pages the same way plain text is.
pub fn word_pages(bytes: &[u8]) -> Result<Vec<String>, String> {
    let unreadable = || "This Word document could not be read.".to_string();
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|_| unreadable())?;
    let xml = zip_entry(&mut archive, "word/document.xml").ok_or_else(unreadable)?;
    // Word paragraphs become blank-line-separated paragraphs.
    Ok(text_pages(&xml_text(&xml, "w:t", "w:p").replace('\n', "\n\n")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joined_letters_in_a_pdf_are_spelled_out() {
        assert_eq!(plain_letters("Classiﬁcation with diﬀerent heads"), "Classification with different heads");
        assert_eq!(plain_letters("eﬃcient workﬂow, ∂P/∂x stays"), "efficient workflow, ∂P/∂x stays");
    }

    #[test]
    fn classifies_by_content_first_then_by_name() {
        assert_eq!(classify("notes.bin", b"%PDF-1.7 ..."), Kind::Pdf);
        assert_eq!(classify("photo", b"\x89PNG\r\n\x1a\n"), Kind::Image("image/png"));
        assert_eq!(classify("photo.jpg", b"\xFF\xD8\xFF\xE0"), Kind::Image("image/jpeg"));
        assert_eq!(classify("memo.m4a", b"\x00\x00\x00\x20ftypM4A "), Kind::Audio);
        assert_eq!(classify("IMG_1.HEIC", b"\x00\x00\x00\x20ftypheic"), Kind::OtherImage);
        assert_eq!(classify("talk.mp3", b"ID3\x03"), Kind::Audio);
        assert_eq!(classify("deck.pptx", b"PK\x03\x04rest"), Kind::Slides);
        assert_eq!(classify("essay.docx", b"PK\x03\x04rest"), Kind::Word);
        assert_eq!(classify("archive.zip", b"PK\x03\x04rest"), Kind::Unknown);
        assert_eq!(classify("notes.md", "# Limits\nπ ≈ 3.14".as_bytes()), Kind::Text);
        assert_eq!(classify("blob", b"\x00\x01\x02"), Kind::Unknown);
    }

    #[test]
    fn text_is_split_at_form_feeds_or_into_chunks() {
        assert_eq!(text_pages("one\u{c}two\u{c}\u{c}three"), ["one", "two", "three"]);
        let long = (0..40).map(|i| format!("Paragraph {i} {}", "word ".repeat(40))).collect::<Vec<_>>().join("\n\n");
        let pages = text_pages(&long);
        assert!(pages.len() > 2 && pages.iter().all(|page| page.len() < 3000));
        assert!(text_pages("  \n ").is_empty());
    }

    #[test]
    fn reads_text_runs_out_of_office_xml() {
        let slide = r#"<p:sld><a:p><a:r><a:t>Hash tables</a:t></a:r></a:p><a:p><a:r><a:t xml:space="preserve">map keys </a:t></a:r><a:r><a:t>&amp; buckets</a:t></a:r></a:p></p:sld>"#;
        assert_eq!(xml_text(slide, "a:t", "a:p"), "Hash tables\nmap keys & buckets\n");
    }
}
