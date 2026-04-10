import { PublicClientApplication } from '@azure/msal-browser';

export const msalConfig = {
  auth: {
    clientId: process.env.REACT_APP_AZURE_CLIENT_ID || '',
    authority: `https://login.microsoftonline.com/${process.env.REACT_APP_AZURE_TENANT_ID || 'common'}`,
    redirectUri: window.location.origin,
  },
  cache: {
    cacheLocation: 'sessionStorage',
    storeAuthStateInCookie: false,
  },
};

export const loginRequest = {
  scopes: ['openid', 'profile', 'email'],
};

// Singleton MSAL instance — initialised lazily on first SSO attempt
let _msalInstance = null;

export async function getMsalInstance() {
  if (!_msalInstance) {
    _msalInstance = new PublicClientApplication(msalConfig);
    await _msalInstance.initialize();
  }
  return _msalInstance;
}

export const ssoEnabled =
  Boolean(process.env.REACT_APP_AZURE_CLIENT_ID) &&
  Boolean(process.env.REACT_APP_AZURE_TENANT_ID);
