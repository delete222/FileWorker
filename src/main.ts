import { createApp } from 'vue'

import App from './App.vue'
import router from "./router";
import i18n from './i18n';
import pinia from './store';

import 'virtual:uno.css'
import "./assets/main.css"
import '@unocss/reset/tailwind.css'

declare global {
  interface Window {
    __pwaInstallPrompt?: Event;
  }
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  window.__pwaInstallPrompt = event;
  window.dispatchEvent(new CustomEvent('pwa-install-available'));
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.error('Service worker registration failed', error);
    });
  });
}

const app = createApp(App);

app.use(router);
app.use(i18n);
app.use(pinia);
app.mount("#app");
