import '@fontsource/jetbrains-mono/700.css';
import '@fontsource/jetbrains-mono/600.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';

const app = mount(App, {
  target: document.getElementById('app') ?? document.body,
});

export default app;
