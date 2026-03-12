# Mazarine Energy Tunisia - Full Stack HR Timesheet System

A complete full-stack HR timesheet management system with PostgreSQL database, Node.js/Express API, and React frontend - all containerized with Docker.

## 🏗️ Architecture

```
┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│   React     │ ───▶ │   Node.js   │ ───▶ │  PostgreSQL │
│  Frontend   │      │    API      │      │   Database  │
│   :3000     │      │   :3001     │      │    :5432    │
└─────────────┘      └─────────────┘      └─────────────┘
```

**Tech Stack:**
- **Frontend**: React 18, Recharts, Custom CSS
- **Backend**: Node.js, Express, JWT Auth
- **Database**: PostgreSQL 15 with JSONB support
- **Deployment**: Docker Compose

## 🚀 Quick Start

### Prerequisites
- Docker 20.10+
- Docker Compose 2.0+
- Git

### Deploy Full Stack

```bash
# Clone and navigate
cd c:\Temp\timesheet

# Start all services
docker-compose -f docker-compose.full.yml up -d

# Wait for database initialization (first run takes ~30 seconds)
# Then access:
# - App: http://localhost:3000
# - API: http://localhost:3001
# - Database Admin: http://localhost:8080 (Adminer)
```

### Default Credentials

| Role | Email | Password |
|------|-------|----------|
| Super Admin | superadmin@mazarine.tn | Maz@Admin2025! |
| Admin | y.gharbi@mazarine.tn | Yasmine@2025 |
| Manager | k.mansour@mazarine.tn | Karim@2025 |
| HR | l.chaabane@mazarine.tn | Lina@2025 |
| Employee | a.bensalah@mazarine.tn | Ahmed@2025 |

## 📁 Project Structure

```
timesheet/
├── mazarine-timesheet-v5.jsx    # Main React app (API-enabled)
├── package.json                  # Frontend dependencies
├── Dockerfile.frontend          # Frontend Docker image
├── nginx.conf                   # Nginx config
├── docker-compose.full.yml      # Full stack orchestration
├── docker-compose.yml           # Frontend only (legacy)
├── README.md                    # This file
│
├── backend/                     # Node.js API
│   ├── server.js               # Express server + API routes
│   ├── package.json            # Backend dependencies
│   ├── Dockerfile              # Backend Docker image
│   └── migrations/
│       └── init.js             # Database schema + seed data
│
└── src/
    ├── index.js                # React entry point
    └── api.js                  # API client utilities
```

## 🔧 API Endpoints

### Authentication
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/login` | Login with email/password |
| POST | `/api/auth/change-password` | Change password |

### Users
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/users` | Get all users |
| GET | `/api/users/:id` | Get user by ID |
| POST | `/api/users` | Create user |
| PUT | `/api/users/:id` | Update user |
| DELETE | `/api/users/:id` | Delete user |

### Projects
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/projects` | Get all projects |
| POST | `/api/projects` | Create project |
| PUT | `/api/projects/:id` | Update project |
| DELETE | `/api/projects/:id` | Delete project |

### Requests (Leave/Mission)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/requests` | Get all requests |
| POST | `/api/requests` | Create request |
| PUT | `/api/requests/:id` | Update request status |
| DELETE | `/api/requests/:id` | Delete request |

### Timesheets
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/timesheets` | Get timesheet entries |
| GET | `/api/timesheets/status` | Get timesheet status |
| POST | `/api/timesheets` | Save timesheet entries |
| PUT | `/api/timesheets/status` | Update timesheet status |

### Roles
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/roles` | Get all roles |
| POST | `/api/roles` | Create/update role |
| DELETE | `/api/roles/:key` | Delete role |

## 🐳 Docker Management

### Commands

```bash
# Start all services
docker-compose -f docker-compose.full.yml up -d

# View logs
docker-compose -f docker-compose.full.yml logs -f

# Stop all services
docker-compose -f docker-compose.full.yml down

# Restart with rebuild
docker-compose -f docker-compose.full.yml up -d --build

# Reset database (WARNING: deletes all data)
docker-compose -f docker-compose.full.yml down -v
docker-compose -f docker-compose.full.yml up -d
```

### Services

| Service | Container Name | Port | Description |
|---------|---------------|------|-------------|
| db | mazarine-db | 5432 | PostgreSQL database |
| api | mazarine-api | 3001 | Node.js/Express API |
| frontend | mazarine-frontend | 3000 | React app via Nginx |
| adminer | mazarine-adminer | 8080 | Database management UI |

## 🔐 Authentication Flow

1. User submits email/password to `/api/auth/login`
2. API validates credentials against PostgreSQL
3. JWT token returned and stored in localStorage
4. Token sent with all subsequent API requests via Authorization header
5. Frontend fetches user data, projects, requests, roles on login

## 🗄️ Database Schema

### Tables

**users** - Employee accounts
- id, email, name, role, type, dept, manager_id, active, leave_balance, used_leave, password, must_change_pwd

**projects** - Company projects
- id, code, name, type, dept, open, field_allowed, office_allowed, color

**requests** - Leave/mission requests
- id, user_id, type, start_date, end_date, comment, days_count, status, review_comment, reviewed_by, reviewed_at

**timesheet_entries** - Daily time entries
- id, user_id, year, month, day, date, activity, locked, hours, allocations (JSONB)

**timesheet_status** - Submission status
- user_id, year, month, status, submitted_at, review_comment, reviewed_by, reviewed_at

**roles** - RBAC roles
- key, label, color, permissions (JSONB), system

## 🛠️ Development

### Local Development (without Docker)

```bash
# Terminal 1: Database
docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=password postgres:15

# Terminal 2: Backend
cd backend
npm install
npm run migrate
npm run dev

# Terminal 3: Frontend
npm install
npm start
```

### Environment Variables

**Backend (backend/.env)**
```
NODE_ENV=development
PORT=3001
DB_HOST=localhost
DB_PORT=5432
DB_NAME=mazarine
DB_USER=postgres
DB_PASSWORD=password
JWT_SECRET=your-secret-key
```

**Frontend**
```
REACT_APP_API_URL=http://localhost:3001/api
```

## 🔒 Security Features

- JWT-based authentication with 24h expiration
- Password hashing with bcrypt
- Role-based access control (RBAC)
- CORS configuration
- Security headers (XSS, CSRF, CSP)
- Input validation with express-validator

## 📊 Performance

- Gzip compression enabled
- Static asset caching (1 year)
- Database connection pooling
- JSONB for flexible timesheet allocations
- Multi-stage Docker builds for smaller images

## 🚨 Troubleshooting

### Database Connection Issues
```bash
# Check database logs
docker logs mazarine-db

# Reset database
docker-compose -f docker-compose.full.yml down -v
docker-compose -f docker-compose.full.yml up -d
```

### API Not Responding
```bash
# Check API logs
docker logs mazarine-api

# Restart API
docker-compose -f docker-compose.full.yml restart api
```

### Frontend 404 Errors
```bash
# Rebuild frontend
docker-compose -f docker-compose.full.yml up -d --build frontend
```

## 📝 Notes

- First startup initializes database with demo data
- Database persists in Docker volume `postgres_data`
- JWT tokens stored in browser localStorage
- All API calls require valid JWT token
- Timesheet allocations stored as JSONB for flexibility

## 🆘 Support

For issues:
1. Check container logs: `docker-compose -f docker-compose.full.yml logs`
2. Verify database: Connect via Adminer at http://localhost:8080
3. Test API: `curl http://localhost:3001/api/health`

## 📄 License

Proprietary - Mazarine Energy Tunisia
