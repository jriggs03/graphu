//! Show the text Graphu reads from each page of a PDF: `cargo run -p graphu-ingest --example pages -- file.pdf`
//! Add `--full` to print every page's whole text.
fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("give a PDF path");
    let full = args.next().as_deref() == Some("--full");
    let bytes = std::fs::read(&path).expect("could not read the file");
    let pages = graphu_ingest::read::pdf_pages(&bytes).expect("could not read the PDF");
    for (index, page) in pages.iter().enumerate() {
        let text = page.split_whitespace().collect::<Vec<_>>().join(" ");
        let shown: String = if full { text.clone() } else { text.chars().take(110).collect() };
        println!("p{:>3} {:>5} chars  {shown}", index + 1, text.chars().count());
    }
}
