import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { register } from './serviceWorkerRegistration';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

register({
  onUpdate: (registration) => {
    const worker = registration.waiting;
    if (worker) {
      worker.postMessage({ type: 'SKIP_WAITING' });
      window.location.reload();
    }
  }
});
