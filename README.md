# Mazarine Energy Tunisia - HR Timesheet Management System

A comprehensive React-based timesheet and HR management system for Mazarine Energy Tunisia, featuring role-based access control, timesheet management, leave requests, approvals, and analytics.

## 🚀 Features

- **Timesheet Management**: Daily time tracking with project allocation
- **Leave Management**: Annual leave, sick leave, and other request types
- **Approval Workflows**: Multi-level approval system for timesheets and requests
- **Role-Based Access Control**: Super Admin, Admin, Manager, HR, and Employee roles
- **Analytics & Reporting**: Comprehensive dashboards and HR reports
- **Field & Office Support**: Different workflows for field and office staff
- **Real-time Dashboard**: Live status updates and notifications

## 🛠️ Technology Stack

- **Frontend**: React 18.2.0
- **Charts**: Recharts 2.8.0
- **Styling**: Custom CSS with modern design system
- **Deployment**: Docker with Nginx
- **Reverse Proxy**: Traefik (optional for production)

## 📋 Prerequisites

- Docker 20.10+
- Docker Compose 2.0+
- Node.js 16+ (for local development)
- Git

## 🐳 Docker Deployment

### Quick Start

1. **Clone the repository**:
   ```bash
   git clone <repository-url>
   cd mazarine-timesheet
   ```

2. **Build and run with Docker Compose**:
   ```bash
   docker-compose up -d
   ```

3. **Access the application**:
   - Application: http://localhost:3000
   - Traefik Dashboard (if enabled): http://localhost:8081

### Production Deployment

For production deployment with reverse proxy:

```bash
docker-compose --profile production up -d
```

This will start:
- Application on port 8080
- Traefik reverse proxy on port 80
- Traefik dashboard on port 8081

### Docker Commands

- **Build the image**:
  ```bash
  docker build -t mazarine-timesheet .
  ```

- **Run standalone container**:
  ```bash
  docker run -d -p 3000:80 --name mazarine-timesheet mazarine-timesheet
  ```

- **View logs**:
  ```bash
  docker-compose logs -f mazarine-timesheet
  ```

- **Stop the application**:
  ```bash
  docker-compose down
  ```

## 🔐 Default Credentials

The application comes with demo accounts:

| Role | Email | Password |
|------|-------|----------|
| Super Admin | superadmin@mazarine.tn | Maz@Admin2025! |
| Admin | y.gharbi@mazarine.tn | Yasmine@2025 |
| Manager | k.mansour@mazarine.tn | Karim@2025 |
| HR | l.chaabane@mazarine.tn | Lina@2025 |
| Employee | a.bensalah@mazarine.tn | Ahmed@2025 |

## 📁 Project Structure

```
mazarine-timesheet/
├── mazarine-timesheet-v5.jsx    # Main React application
├── package.json                  # Node.js dependencies
├── Dockerfile                    # Docker build configuration
├── docker-compose.yml           # Docker Compose configuration
├── nginx.conf                   # Nginx configuration
├── .dockerignore               # Docker ignore file
└── README.md                   # This file
```

## 🔧 Configuration

### Environment Variables

The application can be configured using environment variables:

- `NODE_ENV`: Set to `production` for production deployment
- `PORT`: Application port (default: 3000)

### Nginx Configuration

The Nginx configuration includes:
- Gzip compression
- Security headers
- Static asset caching
- SPA routing support

### Health Checks

The container includes health checks that verify:
- Application is responding on port 80
- Health check interval: 30 seconds
- Timeout: 10 seconds
- Retries: 3

## 🚀 Deployment Options

### Option 1: Docker Compose (Recommended)

```bash
# Development
docker-compose up -d

# Production with reverse proxy
docker-compose --profile production up -d
```

### Option 2: Docker Standalone

```bash
# Build
docker build -t mazarine-timesheet .

# Run
docker run -d -p 3000:80 --name mazarine-timesheet mazarine-timesheet
```

### Option 3: Cloud Deployment

The Docker image can be deployed to:
- AWS ECS/EKS
- Google Cloud Run
- Azure Container Instances
- DigitalOcean App Platform

## 🔍 Monitoring and Logging

- **Application logs**: `docker-compose logs -f mazarine-timesheet`
- **Nginx logs**: Available in container at `/var/log/nginx/`
- **Health checks**: Automatic health monitoring via Docker

## 🛡️ Security Features

- Content Security Policy headers
- XSS protection
- Clickjacking protection
- Gzip compression for performance
- Secure Nginx configuration

## 📊 Performance Optimization

- Multi-stage Docker build for smaller image size
- Static asset caching
- Gzip compression
- Nginx reverse proxy optimization

## 🔄 Updates and Maintenance

To update the application:

1. **Pull latest changes**:
   ```bash
   git pull origin main
   ```

2. **Rebuild and restart**:
   ```bash
   docker-compose down
   docker-compose up -d --build
   ```

3. **Clear browser cache** to see latest changes

## 🐛 Troubleshooting

### Common Issues

1. **Port already in use**:
   ```bash
   # Check what's using port 3000
   netstat -tulpn | grep :3000
   # Or use a different port
   docker-compose up -d --scale mazarine-timesheet=0
   docker-compose up -d -p 3001:80
   ```

2. **Build fails**:
   ```bash
   # Clean build
   docker-compose down
   docker system prune -f
   docker-compose build --no-cache
   ```

3. **Application not loading**:
   ```bash
   # Check logs
   docker-compose logs mazarine-timesheet
   # Verify health status
   docker ps
   ```

### Getting Help

- Check Docker logs: `docker-compose logs -f`
- Verify container status: `docker ps`
- Test locally: Run without Docker first

## 📝 Development

For local development without Docker:

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Start development server**:
   ```bash
   npm start
   ```

3. **Build for production**:
   ```bash
   npm run build
   ```

## 📄 License

This project is proprietary to Mazarine Energy Tunisia.

## 🤝 Support

For support and maintenance:
- Internal IT team
- System administrator
- Development team

---

**Note**: This is a demonstration system with mock data. For production use, integrate with your actual HR systems and databases.
