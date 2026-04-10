FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application code
COPY . .

# Expose port
EXPOSE 3001

# Run database migrations and start server
CMD sh -c "npm run migrate && npm run migrate:sso && npm run migrate:schema && npm run migrate:workflows && npm run migrate:seed-workflows && npm run migrate:project-expiry && npm run migrate:company-entities && npm run migrate:approval-chain && npm run migrate:workflow-designer && npm run migrate:erp-rota && npm start"
