// API utility for backend communication
const API_URL = process.env.REACT_APP_API_URL || '/api';

// Get auth token from localStorage
const getToken = () => localStorage.getItem('token');

// Generic fetch with auth
const fetchWithAuth = async (endpoint, options = {}) => {
  const token = getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(token && { 'Authorization': `Bearer ${token}` }),
    ...options.headers
  };
  
  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  
  return response.json();
};

// Unauthenticated fetch helper (for login endpoints)
const fetchNoAuth = async (endpoint, options = {}) => {
  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const data = await response.json().catch(() => ({ error: 'Unknown error' }));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
};

// Auth API
export const authAPI = {
  login: (email, password) => fetchWithAuth('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  }),

  ssoLogin: (idToken) => fetchNoAuth('/auth/sso', {
    method: 'POST',
    body: JSON.stringify({ idToken }),
  }),

  changePassword: (currentPassword, newPassword) => fetchWithAuth('/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword })
  })
};

// Users API
export const usersAPI = {
  getAll: () => fetchWithAuth('/users'),
  getById: (id) => fetchWithAuth(`/users/${id}`),
  create: (userData) => fetchWithAuth('/users', {
    method: 'POST',
    body: JSON.stringify(userData)
  }),
  update: (id, userData) => fetchWithAuth(`/users/${id}`, {
    method: 'PUT',
    body: JSON.stringify(userData)
  }),
  delete: (id) => fetchWithAuth(`/users/${id}`, {
    method: 'DELETE'
  }),
  resetTOTP: (id) => fetchWithAuth(`/users/${id}/totp`, { method: 'DELETE' }),
  resetPassword: (id, password) => fetchWithAuth(`/users/${id}/password`, {
    method: 'PUT',
    body: JSON.stringify({ password, mustChangePwd: true })
  }),
  importCSV: (users) => fetchWithAuth('/users/import', {
    method: 'POST',
    body: JSON.stringify({ users })
  })
};

// Projects API
export const projectsAPI = {
  getAll: () => fetchWithAuth('/projects'),
  create: (projectData) => fetchWithAuth('/projects', {
    method: 'POST',
    body: JSON.stringify(projectData)
  }),
  update: (id, projectData) => fetchWithAuth(`/projects/${id}`, {
    method: 'PUT',
    body: JSON.stringify(projectData)
  }),
  delete: (id) => fetchWithAuth(`/projects/${id}`, {
    method: 'DELETE'
  }),
  importCSV: (projects) => fetchWithAuth('/projects/import', {
    method: 'POST',
    body: JSON.stringify({ projects })
  })
};

// Requests API
export const requestsAPI = {
  getAll: (params = {}) => {
    const queryString = new URLSearchParams(params).toString();
    return fetchWithAuth(`/requests?${queryString}`);
  },
  create: (requestData) => fetchWithAuth('/requests', {
    method: 'POST',
    body: JSON.stringify(requestData)
  }),
  update: (id, requestData) => fetchWithAuth(`/requests/${id}`, {
    method: 'PUT',
    body: JSON.stringify(requestData)
  }),
  delete: (id) => fetchWithAuth(`/requests/${id}`, {
    method: 'DELETE'
  }),
  cancel: (id, reason) => fetchWithAuth(`/requests/${id}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ reason })
  })
};

// Timesheet API
export const timesheetAPI = {
  getEntries: (userId, year, month) => fetchWithAuth(`/timesheets?userId=${userId}&year=${year}&month=${month}`),
  
  getStatus: (userId, year, month) => fetchWithAuth(`/timesheets/status?userId=${userId}&year=${year}&month=${month}`),
  
  save: (userId, year, month, entries) => fetchWithAuth('/timesheets', {
    method: 'POST',
    body: JSON.stringify({ userId, year, month, entries })
  }),
  
  updateStatus: (userId, year, month, status, reviewComment = '') => fetchWithAuth('/timesheets/status', {
    method: 'PUT',
    body: JSON.stringify({ userId, year, month, status, reviewComment })
  }),

  unlock: (userId, year, month) => fetchWithAuth('/timesheets/unlock', {
    method: 'POST',
    body: JSON.stringify({ userId, year, month })
  }),

  delete: (userId, year, month) => fetchWithAuth(`/timesheets/${userId}/${year}/${month}`, {
    method: 'DELETE'
  }),

  getAllStatuses: () => fetchWithAuth('/timesheets/status/all'),

  reset: (userId, year, month) => fetchWithAuth('/timesheets/reset', {
    method: 'POST',
    body: JSON.stringify({ userId, year, month })
  })
};

// Payroll API
export const payrollAPI = {
  getSummary: (year, month) => fetchWithAuth(`/payroll-summary?year=${year}&month=${month}`)
};

// Roles API
export const rolesAPI = {
  getAll: () => fetchWithAuth('/roles'),
  create: (roleData) => fetchWithAuth('/roles', {
    method: 'POST',
    body: JSON.stringify(roleData)
  }),
  delete: (key) => fetchWithAuth(`/roles/${key}`, {
    method: 'DELETE'
  })
};

// TOTP / 2FA API
export const totpAPI = {
  getStatus:    ()           => fetchWithAuth('/auth/totp/status'),
  setup:        ()           => fetchWithAuth('/auth/totp/setup'),
  enable:       (secret, code) => fetchWithAuth('/auth/totp/enable', { method: 'POST', body: JSON.stringify({ secret, code }) }),
  disable:      (code)       => fetchWithAuth('/auth/totp/disable', { method: 'POST', body: JSON.stringify({ code }) }),
  verifyLogin:  (pendingUserId, code) => fetch(`${API_URL}/auth/totp/verify-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pendingUserId, code })
  }).then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Invalid code'); return d; })
};

// Company Settings API (GET is public — no auth needed for login screen)
export const companyAPI = {
  getSettings: () => fetch(`${API_URL}/company-settings`).then(r => r.json()),
  updateSettings: (data) => fetchWithAuth('/company-settings', { method: 'PUT', body: JSON.stringify(data) })
};

// Rotation Plans API
export const rotationAPI = {
  getAll: () => fetchWithAuth('/rotation-plans'),
  create: (data) => fetchWithAuth('/rotation-plans', { method: 'POST', body: JSON.stringify(data) }),
  update: (id, data) => fetchWithAuth(`/rotation-plans/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id) => fetchWithAuth(`/rotation-plans/${id}`, { method: 'DELETE' })
};

// Activities API
export const activitiesAPI = {
  getAll: () => fetchWithAuth('/activities'),
  create: (data) => fetchWithAuth('/activities', {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  update: (id, data) => fetchWithAuth(`/activities/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data)
  }),
  delete: (id) => fetchWithAuth(`/activities/${id}`, {
    method: 'DELETE'
  })
};

// Holidays API
export const holidaysAPI = {
  getAll: () => fetchWithAuth('/holidays'),
  create: (data) => fetchWithAuth('/holidays', { method: 'POST', body: JSON.stringify(data) }),
  update: (id, data) => fetchWithAuth(`/holidays/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id) => fetchWithAuth(`/holidays/${id}`, { method: 'DELETE' })
};

// Email Settings API
export const emailAPI = {
  getSettings: () => fetchWithAuth('/email-settings'),
  saveSettings: (data) => fetchWithAuth('/email-settings', { method: 'PUT', body: JSON.stringify(data) }),
  testEmail: () => fetchWithAuth('/email-settings/test', { method: 'POST' })
};

// Push Notifications API
export const pushAPI = {
  getVapidKey:     ()    => fetchWithAuth('/push/vapid-key'),
  getSubscription: ()    => fetchWithAuth('/push/subscription'),
  subscribe:       (sub) => fetchWithAuth('/push/subscribe',   { method: 'POST',   body: JSON.stringify(sub) }),
  unsubscribe:     (sub) => fetchWithAuth('/push/unsubscribe', { method: 'DELETE', body: JSON.stringify(sub||{}) }),
  test:            ()    => fetchWithAuth('/push/test',        { method: 'POST' }),
  getStats:        ()    => fetchWithAuth('/push/stats'),
  saveSettings:    (d)   => fetchWithAuth('/push/settings',    { method: 'PUT',    body: JSON.stringify(d) })
};

// Audit Log API
export const auditAPI = {
  getAll: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return fetchWithAuth(`/audit-log${qs ? '?' + qs : ''}`);
  }
};

// Azure Blob Storage — file uploads API
export const uploadsAPI = {
  upload: (file) => {
    const token = getToken();
    const formData = new FormData();
    formData.append('file', file);
    return fetch(`${API_URL}/uploads`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    }).then(async r => {
      const d = await r.json().catch(() => ({ error: 'Unknown error' }));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      return d;
    });
  },
  getDownloadUrl: (blobName) => fetchWithAuth(`/uploads/${encodeURIComponent(blobName)}/url`),
};

// Exports API
export const exportsAPI = {
  payroll: (year, month) => fetchWithAuth('/exports/payroll', {
    method: 'POST',
    body: JSON.stringify({ year, month }),
  }),
};

// Company Entities API
export const companyEntitiesAPI = {
  getAll:  ()         => fetchWithAuth('/company-entities'),
  create:  (data)     => fetchWithAuth('/company-entities', { method: 'POST', body: JSON.stringify(data) }),
  update:  (id, data) => fetchWithAuth(`/company-entities/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete:  (id)       => fetchWithAuth(`/company-entities/${id}`, { method: 'DELETE' }),
};

// Reports API
export const reportsAPI = {
  allocation: (year, month) => fetchWithAuth(`/reports/allocation?year=${year}&month=${month}`),
};
