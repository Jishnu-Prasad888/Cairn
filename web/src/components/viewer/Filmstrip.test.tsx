import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { fileFixture } from '../../test/harness';
import { Filmstrip } from './Filmstrip';

describe('Filmstrip', () => {
  it("draws each thumbnail from its file's own library", () => {
    const siblings = [
      fileFixture({ id: 'a', name: 'a.jpg', library_id: 'lib1' }),
      fileFixture({ id: 'b', name: 'b.jpg', library_id: 'lib2' }),
      fileFixture({ id: 'c', name: 'c.jpg' }),
    ];
    const { container } = render(
      <Filmstrip libraryId="lib1" siblings={siblings} index={0} onNavigate={() => {}} />,
    );
    expect(screen.getAllByRole('button')).toHaveLength(3);
    const srcs = [...container.querySelectorAll('img')].map((img) => img.getAttribute('src'));
    expect(srcs[0]).toContain('/libraries/lib1/files/a/thumbnail');
    // The bug: a lib2 photo asked lib1 for its thumbnail, got a 404, and
    // showed as a blank square.
    expect(srcs[1]).toContain('/libraries/lib2/files/b/thumbnail');
    expect(srcs[2]).toContain('/libraries/lib1/files/c/thumbnail');
  });
});
