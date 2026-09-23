# The Team Test — game server + mobile client on one port.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY shared ./shared
COPY client ./client
ENV PORT=8787 DATA_FILE=/app/data/db.json
EXPOSE 8787
CMD ["node", "src/index.js"]
