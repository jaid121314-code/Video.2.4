FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    fonts-dejavu-core \
    fontconfig \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN ffmpeg -version && ffprobe -version

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY . .

RUN mkdir -p uploads output temp assets/music && chmod 777 uploads output temp

ENV NODE_ENV=production \
    PORT=8080 \
    LOG_LEVEL=info \
    NODE_OPTIONS=--max-old-space-size=512

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8080/health',(r)=>{if(r.statusCode!==200)throw new Error(r.statusCode)})"

EXPOSE 8080

CMD ["node", "index.js"]
