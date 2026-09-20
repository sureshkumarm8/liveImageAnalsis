import config from './config.js';
import ollama from './ollama.js';
import gemini from './gemini.js';

const getProvider = () => config.provider === 'gemini' ? gemini : ollama;

export async function checkProvider() {
  const p = getProvider();
  return config.provider === 'gemini' ? await p.checkProvider() : await p.checkOllama();
}

export const unloadModel = (...args) => getProvider().unloadModel(...args);
export const loadedModels = (...args) => getProvider().loadedModels(...args);
export const analyse = (...args) => getProvider().analyse(...args);
export const analyseFinancialReport = (...args) => getProvider().analyseFinancialReport(...args);

export default { checkProvider, unloadModel, loadedModels, analyse, analyseFinancialReport };
