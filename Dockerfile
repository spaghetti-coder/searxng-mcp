FROM node:24-alpine

RUN apk add --no-cache dumb-init

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

EXPOSE 3000
CMD ["dumb-init", "node", "src/index.js"]
