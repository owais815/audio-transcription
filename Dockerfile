FROM node:20-slim

# Install FFmpeg — needed by fluent-ffmpeg for audio conversion
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (better layer caching — deps change less often than code)
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Ensure upload dirs exist
RUN mkdir -p uploads/raw uploads/processed uploads/chunks

EXPOSE 3000

CMD ["node", "src/server.js"]
