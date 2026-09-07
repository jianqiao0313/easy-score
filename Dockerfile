FROM node:24.18.0-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY index.html ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM node:24.18.0-bookworm-slim AS production-dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev && npm cache clean --force

FROM ubuntu:24.04 AS runtime

LABEL org.opencontainers.image.title="easy-score" \
      org.opencontainers.image.source="https://github.com/jianqiao0313/easy-score"

ARG TARGETARCH
ARG AUDIVERIS_VERSION=5.11.0
ARG AUDIVERIS_SHA256=f20113aaa33b3149ec8d6a09b2a7963360e65fafd92d69389987a85bbc3ec7a3
ARG AUDIVERIS_SOURCE_COMMIT=9e1e55cd2746037d059345881c53e6a6754bffbd
ARG AUDIVERIS_SOURCE_SHA256=b58133b8dabca7aa4e0f43e6286fd667bf06817f5c95115a1b3134add952eae5
ARG TESSDATA_COMMIT=ced78752cc61322fb554c280d13360b35b8684e4
ARG TESSDATA_ENG_SHA256=daa0c97d651c19fba3b25e81317cd697e9908c8208090c94c3905381c23fc047
ARG TESSDATA_LICENSE_SHA256=cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173 \
    DATA_DIR=/data \
    AUDIVERIS_BIN=/opt/audiveris/bin/Audiveris \
    POPPLER_BIN=/usr/bin/pdftoppm \
    PYTHON_BIN=/usr/bin/python3 \
    TESSDATA_PREFIX=/opt/tessdata \
    HOME=/home/easyscore \
    GDK_SCALE=1 \
    LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8

RUN test "$TARGETARCH" = amd64 \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates \
       curl \
       fontconfig \
       fonts-dejavu-core \
       fonts-liberation \
       fonts-noto-core \
       locales \
       poppler-utils \
       python3 \
       python3-pil \
       shared-mime-info \
    && curl -fsSL --retry 3 -o /tmp/audiveris.deb \
       "https://github.com/Audiveris/audiveris/releases/download/${AUDIVERIS_VERSION}/Audiveris-${AUDIVERIS_VERSION}-ubuntu24.04-x86_64.deb" \
    && echo "${AUDIVERIS_SHA256}  /tmp/audiveris.deb" | sha256sum -c - \
    && mkdir -p /usr/share/applications /usr/share/desktop-directories \
    && apt-get install -y --no-install-recommends /tmp/audiveris.deb \
    && mkdir -p /usr/share/source/audiveris \
    && curl -fsSL --retry 3 -o /usr/share/source/audiveris/audiveris-${AUDIVERIS_VERSION}.tar.gz \
       "https://codeload.github.com/Audiveris/audiveris/tar.gz/${AUDIVERIS_SOURCE_COMMIT}" \
    && echo "${AUDIVERIS_SOURCE_SHA256}  /usr/share/source/audiveris/audiveris-${AUDIVERIS_VERSION}.tar.gz" | sha256sum -c - \
    && mkdir -p /opt/tessdata \
    && curl -fsSL --retry 3 -o /opt/tessdata/eng.traineddata \
       "https://raw.githubusercontent.com/tesseract-ocr/tessdata/${TESSDATA_COMMIT}/eng.traineddata" \
    && echo "${TESSDATA_ENG_SHA256}  /opt/tessdata/eng.traineddata" | sha256sum -c - \
    && curl -fsSL --retry 3 -o /opt/tessdata/LICENSE \
       "https://raw.githubusercontent.com/tesseract-ocr/tessdata/${TESSDATA_COMMIT}/LICENSE" \
    && echo "${TESSDATA_LICENSE_SHA256}  /opt/tessdata/LICENSE" | sha256sum -c - \
    && sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen \
    && locale-gen \
    && rm -f /tmp/audiveris.deb \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY --from=node:24.18.0-bookworm-slim /usr/local/ /usr/local/

WORKDIR /app
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY server ./server
COPY LICENSE /usr/share/doc/easy-score/LICENSE
COPY THIRD_PARTY_NOTICES.md /usr/share/doc/easy-score/THIRD_PARTY_NOTICES.md
COPY docker/AUDIVERIS.md /usr/share/doc/easy-score/AUDIVERIS.md

RUN test -s /usr/local/LICENSE \
    && cp /usr/local/LICENSE /usr/share/doc/easy-score/NODE_LICENSE \
    && dpkg-query -W -f='${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\n' \
       > /usr/share/doc/easy-score/debian-packages.tsv \
    && groupadd --system --gid 10001 easyscore \
    && useradd --system --uid 10001 --gid easyscore --create-home easyscore \
    && mkdir -p /data/jobs /data/demo \
    && chown -R easyscore:easyscore /data /home/easyscore

USER easyscore
VOLUME ["/data"]
EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4173/api/health').then(async r=>{const h=await r.json();if(!r.ok||!h.ok||!h.engine?.available)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server/index.mjs"]
