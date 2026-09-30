import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { zh } from '../../shared/strings.zh-CN';
import { App } from './App';

const root = document.getElementById('root');
if (root === null) throw new Error(zh.app.rootElementMissing);
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
