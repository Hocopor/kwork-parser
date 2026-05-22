export interface KworkProject {
  id: string; // unique identifier, e.g., hashed url or ID from Kwork (like parsed link ID)
  categoryUrl: string; // original category URL it belongs to
  title: string;
  budget: string; // e.g. "Желаемый бюджет: 5 000 руб." or "Цена до: 2 000 руб."
  description: string;
  offersCount: number; // number of offers currently
  createdAtText: string; // created time label
  link: string; // full link on kwork
  scrapedAt: string; // ISO string
}

export interface KworkCategory {
  id: string;
  url: string;
  name: string; // human-readable name extracted or custom
  addedAt: string; // ISO string
}

export interface LogEntry {
  id: string;
  timestamp: string;
  type: 'info' | 'success' | 'warning' | 'error';
  message: string;
}

export interface ParserStatus {
  isParsingActive: boolean;
  activeCategoriesCount: number;
  totalParsedProjectsCount: number;
  totalSentAlertsCount: number;
  uptimeSeconds: number;
  lastRunTimestamp: string | null;
  errorCount: number;
}
