# Graphu in one image: the built frontend, the Rust server, and whisper.cpp for voice notes.
#
#   docker build -t graphu .
#   docker run -p 8000:8000 -v graphu-data:/data -e ANTHROPIC_API_KEY=your-key graphu
#
# Graphs live in /data, so mount a volume there or they are lost when the container is replaced.

# 1. Build the frontend (web/dist).
FROM node:22-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# 2. Build the server.
FROM rust:1-slim-trixie AS server
RUN apt-get update && apt-get install -y --no-install-recommends build-essential && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY crates crates
RUN cargo build --release -p graphu-server

# 3. Build whisper.cpp and fetch a speech model. GGML_NATIVE=OFF keeps the binary portable:
#    it is not tuned to the CPU of the machine that builds the image.
#    "base" (about 150 MB) keeps transcription quick on a small server. Use
#    --build-arg WHISPER_MODEL=small for better accuracy at about three times the work.
FROM debian:trixie-slim AS whisper
RUN apt-get update && apt-get install -y --no-install-recommends git cmake build-essential curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch v1.9.5 https://github.com/ggml-org/whisper.cpp /whisper \
    && cmake -S /whisper -B /whisper/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
       -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF -DGGML_NATIVE=OFF \
    && cmake --build /whisper/build --target whisper-cli -j
ARG WHISPER_MODEL=base
RUN curl -L --fail -o /ggml.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${WHISPER_MODEL}.bin

# 4. The image that runs.
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libgomp1 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=server /app/target/release/graphu-server /usr/local/bin/graphu-server
COPY --from=whisper /whisper/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper /ggml.bin /app/models/ggml.bin
COPY --from=web /app/web/dist /app/web
COPY scripts/transcribe.sh /app/scripts/transcribe.sh
ENV GRAPHU_DB=/data/graphu.sqlite3 \
    GRAPHU_WEB=/app/web \
    GRAPHU_ADDR=0.0.0.0:8000 \
    GRAPHU_WHISPER_MODEL=/app/models/ggml.bin \
    GRAPHU_TRANSCRIBE_CMD='/app/scripts/transcribe.sh "$1"'
VOLUME /data
EXPOSE 8000
CMD ["graphu-server"]
