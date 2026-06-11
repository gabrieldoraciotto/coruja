import axios from 'axios';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'https://postgres-production-f2e4a.up.railway.app';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

export interface Source {
  id: string;
  name: string;
  feedUrl: string;
  type: string;
  active: boolean;
  createdAt: string;
}

export interface Article {
  id: string;
  title: string;
  summary?: string;
  link: string;
  source: Source;
  relevanceScore: number;
  collectedAt: string;
}

export interface Draft {
  id: string;
  article: Article;
  hook: string;
  script: string;
  caption: string;
  format: string;
  createdAt: string;
}

export const apiService = {
  // Status
  async getStatus() {
    return api.get('/');
  },

  // Sources
  async getSources() {
    return api.get<Source[]>('/sources');
  },

  async createSource(source: Omit<Source, 'id' | 'createdAt'>) {
    return api.post<Source>('/sources', source);
  },

  // Articles
  async getArticles() {
    return api.get<Article[]>('/articles');
  },

  // Drafts
  async getDrafts() {
    return api.get<Draft[]>('/drafts');
  },

  async createDraft(articleId: string, format: 'reel' | 'carrossel' = 'reel') {
    return api.post<Draft>('/drafts', { articleId, format });
  },

  // Calendar
  async getCalendar() {
    return api.get('/calendar');
  },

  // Ingest
  async runIngest() {
    return api.post('/ingest', {});
  },
};
