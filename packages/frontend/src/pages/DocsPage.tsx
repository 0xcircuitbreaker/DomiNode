import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Link } from "react-router-dom";
import { useTheme } from "../context/ThemeContext";
import ThemeToggle from "../components/ThemeToggle";
import { BRAND_MARK, BRAND_NAME } from "../config/branding";
import {
  DOC_SECTIONS,
  type DocContent,
  type DocSection,
  type DocSubsection,
  type Endpoint,
  type Param,
} from "../data/docs-content";
import "./DocsPage.css";

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

interface SearchEntry {
  sectionId: string;
  sectionTitle: string;
  subsectionId: string;
  subsectionTitle: string;
  textContent: string;
}

function buildSearchIndex(sections: DocSection[]): SearchEntry[] {
  const entries: SearchEntry[] = [];
  for (const section of sections) {
    for (const sub of section.subsections) {
      const texts: string[] = [sub.title];
      if (sub.searchTerms) texts.push(...sub.searchTerms);
      for (const block of sub.content) {
        if (block.type === "text") texts.push(block.text);
        else if (block.type === "code") { if (block.label) texts.push(block.label); }
        else if (block.type === "heading") texts.push(block.text);
        else if (block.type === "note") texts.push(block.text);
        else if (block.type === "param-table") {
          for (const p of block.params) texts.push(p.name, p.description);
        } else if (block.type === "endpoint-table") {
          for (const ep of block.endpoints) texts.push(ep.path, ep.description);
        }
      }
      entries.push({
        sectionId: section.id,
        sectionTitle: section.title,
        subsectionId: sub.id,
        subsectionTitle: sub.title,
        textContent: texts.join(" ").toLowerCase(),
      });
    }
  }
  return entries;
}

function searchDocs(index: SearchEntry[], query: string): SearchEntry[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  return index
    .filter((e) => e.subsectionTitle.toLowerCase().includes(q) || e.textContent.includes(q))
    .slice(0, 10);
}

// ---------------------------------------------------------------------------
// CodeBlock
// ---------------------------------------------------------------------------

function CodeBlock({ lang, code, label }: { lang: string; code: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="docs-code-block">
      {label && <div className="docs-code-label">{label}</div>}
      <div className="docs-code-inner">
        <button className="docs-copy-btn" onClick={handleCopy} aria-label="Copy code">
          {copied ? "Copied!" : "Copy"}
        </button>
        <pre><code className={`language-${lang}`}>{code}</code></pre>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EndpointBadge
// ---------------------------------------------------------------------------

const METHOD_CLASSES: Record<string, string> = {
  GET: "badge-get",
  POST: "badge-post",
  PUT: "badge-put",
  PATCH: "badge-patch",
  DELETE: "badge-delete",
};

function EndpointBadge({ method }: { method: string }) {
  return (
    <span className={`docs-method-badge ${METHOD_CLASSES[method] ?? "badge-get"}`}>
      {method}
    </span>
  );
}

const AUTH_CLASSES: Record<string, string> = {
  "Public": "auth-public",
  "JWT": "auth-jwt",
  "API Key": "auth-apikey",
  "Signature": "auth-sig",
  "JWT | API Key": "auth-jwt",
};

function AuthBadge({ auth }: { auth: string }) {
  return (
    <span className={`docs-auth-badge ${AUTH_CLASSES[auth] ?? "auth-public"}`}>
      {auth}
    </span>
  );
}

// ---------------------------------------------------------------------------
// EndpointTable
// ---------------------------------------------------------------------------

function EndpointTable({ endpoints }: { endpoints: Endpoint[] }) {
  return (
    <div className="docs-table-wrap">
      <table className="docs-endpoint-table">
        <thead>
          <tr>
            <th>Method</th>
            <th>Path</th>
            <th>Auth</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          {endpoints.map((ep) => (
            <tr key={`${ep.method}-${ep.path}`}>
              <td><EndpointBadge method={ep.method} /></td>
              <td><code className="docs-path">{ep.path}</code></td>
              <td><AuthBadge auth={ep.auth} /></td>
              <td>{ep.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ParamTable
// ---------------------------------------------------------------------------

function ParamTable({ params }: { params: Param[] }) {
  return (
    <div className="docs-table-wrap">
      <table className="docs-param-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Required</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          {params.map((p) => (
            <tr key={p.name}>
              <td><code className="docs-path">{p.name}</code></td>
              <td><span className="docs-type-badge">{p.type}</span></td>
              <td>{p.required ? <span className="docs-required">Yes</span> : <span className="docs-optional">—</span>}</td>
              <td>{p.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NoteBlock
// ---------------------------------------------------------------------------

const NOTE_ICONS: Record<string, string> = {
  info: "ℹ️",
  warning: "⚠️",
  danger: "🚨",
  tip: "💡",
};

function NoteBlock({ variant, text }: { variant: "info" | "warning" | "danger" | "tip"; text: string }) {
  return (
    <div className={`docs-note docs-note-${variant}`}>
      <span className="docs-note-icon">{NOTE_ICONS[variant]}</span>
      <span className="docs-note-text">{text}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Content Renderer
// ---------------------------------------------------------------------------

function renderContent(blocks: DocContent[]) {
  return blocks.map((block, i) => {
    if (block.type === "text") return <p key={i} className="docs-text">{block.text}</p>;
    if (block.type === "code") return <CodeBlock key={i} lang={block.lang} code={block.code} label={block.label} />;
    if (block.type === "endpoint-table") return <EndpointTable key={i} endpoints={block.endpoints} />;
    if (block.type === "param-table") return <ParamTable key={i} params={block.params} />;
    if (block.type === "note") return <NoteBlock key={i} variant={block.variant} text={block.text} />;
    if (block.type === "heading") {
      if (block.level === 3) return <h3 key={i} className="docs-h3">{block.text}</h3>;
      return <h4 key={i} className="docs-h4">{block.text}</h4>;
    }
    return null;
  });
}

// ---------------------------------------------------------------------------
// DocsSearchBar
// ---------------------------------------------------------------------------

interface SearchBarProps {
  searchIndex: SearchEntry[];
  onSelect: (entry: SearchEntry) => void;
  inputRef: React.RefObject<HTMLInputElement>;
}

function DocsSearchBar({ searchIndex, onSelect, inputRef }: SearchBarProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchEntry[]>([]);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const hits = searchDocs(searchIndex, query);
    setResults(hits);
    setActiveIdx(-1);
    setOpen(hits.length > 0 && query.length > 0);
  }, [query, searchIndex]);

  // Close on outside click
  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, -1));
    } else if (e.key === "Enter") {
      if (activeIdx >= 0 && results[activeIdx]) {
        onSelect(results[activeIdx]);
        setQuery("");
        setOpen(false);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
      setQuery("");
    }
  }

  return (
    <div className="docs-search-wrap" ref={containerRef}>
      <div className="docs-search-field">
        <svg className="docs-search-icon" viewBox="0 0 20 20" fill="none">
          <circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <input
          ref={inputRef}
          className="docs-search-input"
          type="search"
          placeholder="Search docs… (Ctrl+K)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => { if (results.length > 0) setOpen(true); }}
          aria-label="Search documentation"
          aria-autocomplete="list"
          aria-expanded={open}
        />
      </div>
      {open && results.length > 0 && (
        <ul className="docs-search-dropdown" role="listbox">
          {results.map((r, idx) => (
            <li
              key={`${r.sectionId}-${r.subsectionId}`}
              role="option"
              aria-selected={idx === activeIdx}
              className={`docs-search-result ${idx === activeIdx ? "docs-search-result-active" : ""}`}
              onMouseDown={() => { onSelect(r); setQuery(""); setOpen(false); }}
            >
              <span className="docs-result-section">{r.sectionTitle}</span>
              <span className="docs-result-divider">›</span>
              <span className="docs-result-sub">{r.subsectionTitle}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DocSidebar
// ---------------------------------------------------------------------------

interface SidebarProps {
  sections: DocSection[];
  activeSectionId: string;
  activeSubId: string;
  onNavigate: (sectionId: string, subId: string) => void;
}

function DocSidebar({ sections, activeSectionId, activeSubId, onNavigate }: SidebarProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    sections.forEach((s) => { init[s.id] = true; });
    return init;
  });

  function toggle(id: string) {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  return (
    <nav className="docs-sidebar" aria-label="Documentation navigation">
      {sections.map((section) => (
        <div key={section.id} className="docs-sidebar-section">
          <button
            className={`docs-sidebar-heading ${activeSectionId === section.id ? "docs-sidebar-heading-active" : ""}`}
            onClick={() => toggle(section.id)}
            aria-expanded={expanded[section.id]}
          >
            <span className="docs-sidebar-icon">{section.icon}</span>
            <span className="docs-sidebar-label">{section.title}</span>
            <span className={`docs-sidebar-chevron ${expanded[section.id] ? "docs-chevron-open" : ""}`}>›</span>
          </button>
          {expanded[section.id] && (
            <ul className="docs-sidebar-list">
              {section.subsections.map((sub) => (
                <li key={sub.id}>
                  <button
                    className={`docs-sidebar-item ${activeSubId === sub.id ? "docs-sidebar-item-active" : ""}`}
                    onClick={() => onNavigate(section.id, sub.id)}
                  >
                    {sub.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// SubsectionRenderer
// ---------------------------------------------------------------------------

function SubsectionBlock({ section, subsection }: { section: DocSection; subsection: DocSubsection }) {
  return (
    <div className="docs-subsection" id={subsection.id} data-section={section.id}>
      <h2 className="docs-subsection-title">
        {subsection.title}
        <a className="docs-anchor" href={`#${subsection.id}`} aria-label={`Link to ${subsection.title}`}>#</a>
      </h2>
      {renderContent(subsection.content)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DocsPage
// ---------------------------------------------------------------------------

export default function DocsPage() {
  const { theme } = useTheme();
  const [activeSectionId, setActiveSectionId] = useState(DOC_SECTIONS[0].id);
  const [activeSubId, setActiveSubId] = useState(DOC_SECTIONS[0].subsections[0].id);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const searchIndex = useMemo(() => buildSearchIndex(DOC_SECTIONS), []);

  // Ctrl+K focuses search
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // IntersectionObserver to track active subsection on scroll
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const id = entry.target.id;
            const sectionAttr = (entry.target as HTMLElement).dataset.section;
            if (id) setActiveSubId(id);
            if (sectionAttr) setActiveSectionId(sectionAttr);
          }
        }
      },
      { rootMargin: "-20% 0px -60% 0px", threshold: 0 }
    );

    const subsections = contentRef.current?.querySelectorAll(".docs-subsection");
    subsections?.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  // Handle hash on load
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (hash) {
      setTimeout(() => {
        const el = document.getElementById(hash);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 100);
    }
  }, []);

  const navigateTo = useCallback((sectionId: string, subId: string) => {
    setActiveSectionId(sectionId);
    setActiveSubId(subId);
    setMobileNavOpen(false);
    setTimeout(() => {
      const el = document.getElementById(subId);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        window.history.replaceState(null, "", `#${subId}`);
      }
    }, 50);
  }, []);

  function handleSearchSelect(entry: SearchEntry) {
    navigateTo(entry.sectionId, entry.subsectionId);
  }

  return (
    <div className="docs-root" data-theme={theme}>
      {/* Header */}
      <header className="docs-header">
        <div className="docs-header-inner">
          <Link to="/" className="docs-brand">
            <img src="/logo.svg" alt={BRAND_MARK} className="docs-brand-mark" />
            <span className="docs-brand-name">{BRAND_NAME}</span>
            <span className="docs-brand-sep">/</span>
            <span className="docs-brand-section">Docs</span>
          </Link>

          <DocsSearchBar
            searchIndex={searchIndex}
            onSelect={handleSearchSelect}
            inputRef={searchInputRef}
          />

          <div className="docs-header-actions">
            <ThemeToggle compact className="docs-theme-toggle" />
            <Link to="/" className="docs-back-link">← Home</Link>
            <button
              className={`docs-hamburger${mobileNavOpen ? " docs-hamburger-open" : ""}`}
              onClick={() => setMobileNavOpen(!mobileNavOpen)}
              aria-label="Toggle navigation"
            >
              <span />
            </button>
          </div>
        </div>
      </header>

      {/* Mobile nav overlay */}
      {mobileNavOpen && (
        <div className="docs-mobile-overlay" onClick={() => setMobileNavOpen(false)}>
          <div className="docs-mobile-sidebar" onClick={(e) => e.stopPropagation()}>
            <DocSidebar
              sections={DOC_SECTIONS}
              activeSectionId={activeSectionId}
              activeSubId={activeSubId}
              onNavigate={navigateTo}
            />
          </div>
        </div>
      )}

      <div className="docs-layout">
        {/* Desktop Sidebar */}
        <aside className="docs-sidebar-wrap">
          <DocSidebar
            sections={DOC_SECTIONS}
            activeSectionId={activeSectionId}
            activeSubId={activeSubId}
            onNavigate={navigateTo}
          />
        </aside>

        {/* Content */}
        <main className="docs-content" ref={contentRef}>
          {DOC_SECTIONS.map((section) => (
            <div key={section.id} className="docs-section" id={section.id}>
              <div className="docs-section-header">
                <span className="docs-section-icon">{section.icon}</span>
                <h1 className="docs-section-title">{section.title}</h1>
              </div>
              {section.subsections.map((sub) => (
                <SubsectionBlock key={sub.id} section={section} subsection={sub} />
              ))}
            </div>
          ))}

          <div className="docs-footer">
            <p>© {new Date().getFullYear()} {BRAND_NAME}. Documentation for {BRAND_NAME} proxy service.</p>
            <div className="docs-footer-links">
              <Link to="/privacy">Privacy Policy</Link>
              <Link to="/terms">Terms of Service</Link>
              <Link to="/aup">Acceptable Use</Link>
              <Link to="/docs/error-codes">Error Codes</Link>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
