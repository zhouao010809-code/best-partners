import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import './styles/tokens.css';
import './styles/global.css';
import './styles/shell.css';
import './styles/intake.css';
import './styles/extraction.css';
import './styles/queue-workspace.css';
import './styles/ingestion.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');
createRoot(root).render(<StrictMode><App /></StrictMode>);
