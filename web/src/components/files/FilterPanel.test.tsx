import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { FilterPanel } from './FilterPanel';
import { EMPTY_RANGE, type RangeFilters } from './filters';

let latest: RangeFilters = EMPTY_RANGE;

function Harness() {
  const [value, setValue] = useState<RangeFilters>(EMPTY_RANGE);
  const onChange = (next: RangeFilters) => {
    latest = next;
    setValue(next);
  };
  return <FilterPanel value={value} onChange={onChange} tagOptions={['Beach', 'family']} />;
}

describe('FilterPanel tags', () => {
  it('toggles tags and the match-all switch', () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('tag-filter-button'));

    fireEvent.click(screen.getByTestId('filter-tag-Beach'));
    fireEvent.click(screen.getByTestId('filter-tag-family'));
    expect(latest.tags).toEqual(['Beach', 'family']);
    expect(latest.tagsAll).toBe(false);
    expect(screen.getByTestId('filter-tag-Beach')).toBeChecked();
    expect(screen.getByTestId('tag-filter-button')).toHaveTextContent('2 selected');

    fireEvent.click(screen.getByTestId('filter-tags-all'));
    expect(latest.tagsAll).toBe(true);

    fireEvent.click(screen.getByTestId('filter-tag-Beach'));
    expect(latest.tags).toEqual(['family']);

    // The search narrows a long list.
    fireEvent.change(screen.getByLabelText('Find a tag'), { target: { value: 'bea' } });
    expect(screen.queryByTestId('filter-tag-family')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(latest).toEqual(EMPTY_RANGE);
  });
});
