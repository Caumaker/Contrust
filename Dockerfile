FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 5101 5102 5103 6001
# One container, whole demo network. For a real network run one peer per container: CMD ["node", "ledger/index.js"]
CMD ["node", "scripts/demo.js"]
