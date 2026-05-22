FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache git

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY config ./config

RUN mkdir -p /app/auth_info_baileys

ENV NODE_ENV=production

CMD ["node", "src/index.js"]
