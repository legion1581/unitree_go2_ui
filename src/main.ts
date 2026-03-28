import './ui/styles.css';
import { App } from './ui/app';

const root = document.getElementById('app');
if (root) {
  new App(root);
}
