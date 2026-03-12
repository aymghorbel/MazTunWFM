FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application code
COPY . .

# Create build directory for frontend integration
RUN mkdir -p build

# Expose port
EXPOSE 3001

# Run database migrations and start server
CMD sh -c "npm run migrate && npm start"
