import { useState, useEffect } from 'react';
import './App.css';
import { apiService } from './api';
import type { Source, Article, Draft } from './api';

type Tab = 'dashboard' | 'articles' | 'drafts' | 'sources';

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const [sources, setSources] = useState<Source[]>([]);
  const [articles, setArticles] = useState<Article[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [sourcesRes, articlesRes, draftsRes] = await Promise.all([
        apiService.getSources(),
        apiService.getArticles(),
        apiService.getDrafts(),
      ]);
      setSources(sourcesRes.data);
      setArticles(articlesRes.data);
      setDrafts(draftsRes.data);
    } catch (err) {
      setError('Erro ao carregar dados');
    } finally {
      setLoading(false);
    }
  };

  const handleRunIngest = async () => {
    setLoading(true);
    try {
      await apiService.runIngest();
      setTimeout(loadData, 2000);
    } catch (err) {
      setError('Erro ao executar coleta');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>📰 Pauta Jurídica</h1>
        <p>Esteira de produção de conteúdo previdenciário</p>
      </header>

      <nav className="app-nav">
        <button
          className={`nav-btn ${activeTab === 'dashboard' ? 'active' : ''}`}
          onClick={() => setActiveTab('dashboard')}
        >
          📊 Dashboard
        </button>
        <button
          className={`nav-btn ${activeTab === 'articles' ? 'active' : ''}`}
          onClick={() => setActiveTab('articles')}
        >
          📰 Notícias ({articles.length})
        </button>
        <button
          className={`nav-btn ${activeTab === 'drafts' ? 'active' : ''}`}
          onClick={() => setActiveTab('drafts')}
        >
          🎬 Roteiros ({drafts.length})
        </button>
        <button
          className={`nav-btn ${activeTab === 'sources' ? 'active' : ''}`}
          onClick={() => setActiveTab('sources')}
        >
          🔗 Fontes ({sources.length})
        </button>
      </nav>

      {error && <div className="error-banner">{error}</div>}

      <main className="app-main">
        {loading && <div className="loading">Carregando...</div>}

        {activeTab === 'dashboard' && (
          <Dashboard
            sources={sources}
            articles={articles}
            drafts={drafts}
            onRunIngest={handleRunIngest}
            loading={loading}
          />
        )}

        {activeTab === 'articles' && <Articles articles={articles} />}

        {activeTab === 'drafts' && <Drafts drafts={drafts} />}

        {activeTab === 'sources' && <Sources sources={sources} />}
      </main>
    </div>
  );
}

function Dashboard({
  sources,
  articles,
  drafts,
  onRunIngest,
  loading,
}: {
  sources: Source[];
  articles: Article[];
  drafts: Draft[];
  onRunIngest: () => void;
  loading: boolean;
}) {
  const relevantArticles = articles.filter((a) => a.relevanceScore >= 60);

  return (
    <div className="dashboard">
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-value">{sources.length}</div>
          <div className="stat-label">Fontes RSS</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{articles.length}</div>
          <div className="stat-label">Notícias</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{relevantArticles.length}</div>
          <div className="stat-label">Relevantes</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{drafts.length}</div>
          <div className="stat-label">Roteiros</div>
        </div>
      </div>

      <div className="dashboard-section">
        <h2>🔄 Coleta de Notícias</h2>
        <button className="btn btn-primary" onClick={onRunIngest} disabled={loading}>
          {loading ? 'Coletando...' : '▶️ Executar Coleta Agora'}
        </button>
      </div>

      {relevantArticles.length > 0 && (
        <div className="dashboard-section">
          <h2>📌 Últimas Notícias Relevantes</h2>
          <div className="articles-preview">
            {relevantArticles.slice(0, 3).map((article) => (
              <div key={article.id} className="article-preview">
                <h3>{article.title}</h3>
                <p className="source-name">📌 {article.source.name}</p>
                <p className="relevance">Relevância: {article.relevanceScore}/100</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Articles({ articles }: { articles: Article[] }) {
  return (
    <div className="section">
      <h2>📰 Notícias Coletadas</h2>
      {articles.length === 0 ? (
        <p className="empty">Nenhuma notícia coletada ainda.</p>
      ) : (
        <div className="articles-list">
          {articles.map((article) => (
            <div key={article.id} className="article-item">
              <h3>{article.title}</h3>
              <p className="summary">{article.summary}</p>
              <div className="article-meta">
                <span className="badge">{article.source.name}</span>
                <span className={`badge ${article.relevanceScore >= 60 ? 'badge-relevant' : ''}`}>
                  {article.relevanceScore}/100
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Drafts({ drafts }: { drafts: Draft[] }) {
  return (
    <div className="section">
      <h2>🎬 Roteiros Gerados</h2>
      {drafts.length === 0 ? (
        <p className="empty">Nenhum roteiro gerado ainda.</p>
      ) : (
        <div className="drafts-list">
          {drafts.map((draft) => (
            <div key={draft.id} className="draft-item">
              <h3>{draft.article.title}</h3>
              <div className="draft-content">
                <div><strong>Hook:</strong> {draft.hook}</div>
                <div><strong>Formato:</strong> {draft.format}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Sources({ sources }: { sources: Source[] }) {
  return (
    <div className="section">
      <h2>🔗 Fontes RSS ({sources.length})</h2>
      {sources.length === 0 ? (
        <p className="empty">Nenhuma fonte configurada.</p>
      ) : (
        <div className="sources-list">
          {sources.map((source) => (
            <div key={source.id} className="source-item">
              <h3>{source.name}</h3>
              <p className="source-url">{source.feedUrl}</p>
              <span className="badge">{source.type}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
