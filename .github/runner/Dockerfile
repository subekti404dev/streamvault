FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update -qq \
    -o Acquire::Retries=3 \
    -o Acquire::http::Timeout=30 \
    -o Acquire::https::Timeout=30 \
    && apt-get install -y -qq --no-install-recommends \
        ca-certificates \
        curl \
        jq \
        bc \
        ffmpeg \
        transmission-daemon \
        transmission-cli \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# transmission-daemon needs /etc/transmission-daemon to exist
RUN mkdir -p /etc/transmission-daemon

CMD ["bash"]
