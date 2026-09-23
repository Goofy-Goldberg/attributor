FROM node:24-slim

WORKDIR /app
COPY auth/package*.json ./
RUN npm ci --omit=dev
COPY auth/*.mjs ./

EXPOSE 3000
CMD ["npm", "start"]
