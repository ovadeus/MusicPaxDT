/// Which optional library-table columns are shown. Title and Artist are always
/// visible; these are user-toggleable in Settings. Pure UI preference,
/// persisted in localStorage.
export interface ColumnPrefs {
  album: boolean;
  genre: boolean;
  year: boolean;
  length: boolean;
  plays: boolean;
}

export const COLUMN_TOGGLES: { key: keyof ColumnPrefs; label: string }[] = [
  { key: "album", label: "Album" },
  { key: "genre", label: "Genre" },
  { key: "year", label: "Year" },
  { key: "length", label: "Length" },
  { key: "plays", label: "Plays" },
];

const KEY = "library.columnPrefs";
// Genre and Plays default off to keep the listening table calm; users can turn
// either on from Settings.
const DEFAULTS: ColumnPrefs = {
  album: true,
  genre: false,
  year: true,
  length: true,
  plays: false,
};

export function loadColumnPrefs(): ColumnPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}");
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveColumnPrefs(prefs: ColumnPrefs): void {
  localStorage.setItem(KEY, JSON.stringify(prefs));
}
