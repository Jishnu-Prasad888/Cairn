/** The date, size and tag bounds a listing can be narrowed by. */

export interface RangeFilters {
  minSizeMb: string;
  maxSizeMb: string;
  from: string;
  to: string;
  /** Tag names; a file matches any of them, or all with `tagsAll`. */
  tags: string[];
  tagsAll: boolean;
}

export const EMPTY_RANGE: RangeFilters = {
  minSizeMb: '',
  maxSizeMb: '',
  from: '',
  to: '',
  tags: [],
  tagsAll: false,
};

export const hasRangeFilters = (f: RangeFilters) =>
  f.minSizeMb !== '' || f.maxSizeMb !== '' || f.from !== '' || f.to !== '' || f.tags.length > 0;
