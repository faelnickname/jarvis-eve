FROM node:20-slim

RUN apt-get update && apt-get install -y \
    python3 python3-pip \
    chromium \
    ffmpeg \
    fonts-liberation \
    fonts-noto-color-emoji \
    ca-certificates \
    --no-install-recommends \
    && pip3 install pdfplumber openpyxl pillow moviepy --break-system-packages \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p "Documents and Projects" system

EXPOSE 3000
CMD ["node", "server.js"]
