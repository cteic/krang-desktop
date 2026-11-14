import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Placeholder } from './placeholder';

describe('Placeholder', () => {
  it('renders its label', () => {
    render(<Placeholder label="ui" />);

    expect(screen.getByText('ui on core')).toBeDefined();
  });
});
