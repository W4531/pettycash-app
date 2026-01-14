# Node LTS
FROM node:20-slim

# Create app directory
WORKDIR /app

# Install deps first (better layer cache)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Cloud Run uses PORT env. Your code listens on process.env.PORT.
ENV NODE_ENV=production

# Optional but standard
EXPOSE 8080

CMD ["npm", "start"]