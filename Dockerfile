FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY config ./config

RUN mkdir -p /app/auth_info_baileys

ENV NODE_ENV=production
ENV AUTH_DIR=/app/auth_info_baileys

CMD ["node", "src/index.js"]
