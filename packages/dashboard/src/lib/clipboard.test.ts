/** @module lib/clipboard.test — `copyText`: the Clipboard API in a secure context, the `execCommand` fallback otherwise or when it rejects, and cleanup of the temporary textarea */
import { describe, expect, it } from 'bun:test';
import { copyText } from './clipboard.ts';

/** A minimal `Document` double: a `defaultView` with the given clipboard and secure flag, and a recording `execCommand`. */
function fakeDocument(options: {
  readonly secure: boolean;
  readonly writeText?: (value: string) => Promise<void>;
  readonly execCommand?: () => boolean;
}) {
  const doc = document.implementation.createHTMLDocument('copy');
  const copied: string[] = [];
  const view = {
    isSecureContext: options.secure,
    navigator: {
      clipboard: options.writeText === undefined ? undefined : { writeText: options.writeText },
    },
  };
  Object.defineProperty(doc, 'defaultView', { value: view });
  Object.defineProperty(doc, 'execCommand', {
    value: (command: string) => {
      const area = doc.body.querySelector('textarea');
      if (command === 'copy' && area !== null) copied.push(area.value);
      return options.execCommand?.() ?? true;
    },
  });
  return { doc, copied };
}

describe('copyText', () => {
  it('uses the Clipboard API in a secure context', async () => {
    const written: string[] = [];
    const { doc, copied } = fakeDocument({
      secure: true,
      writeText: async (value) => {
        written.push(value);
      },
    });
    expect(await copyText('browserhive --admin', doc)).toBe(true);
    expect(written).toEqual(['browserhive --admin']);
    expect(copied).toEqual([]);
  });

  it('falls back to execCommand in an insecure context and removes the textarea', async () => {
    const { doc, copied } = fakeDocument({ secure: false, writeText: async () => undefined });
    expect(await copyText('browserhive doctor', doc)).toBe(true);
    expect(copied).toEqual(['browserhive doctor']);
    expect(doc.body.querySelector('textarea')).toBeNull();
  });

  it('falls back when the Clipboard API rejects', async () => {
    const { doc, copied } = fakeDocument({
      secure: true,
      writeText: async () => {
        throw new DOMException('Document is not focused', 'NotAllowedError');
      },
    });
    expect(await copyText('x', doc)).toBe(true);
    expect(copied).toEqual(['x']);
  });

  it('reports false when execCommand fails or throws', async () => {
    expect(await copyText('x', fakeDocument({ secure: false, execCommand: () => false }).doc)).toBe(
      false,
    );
    const throwing = fakeDocument({
      secure: false,
      execCommand: () => {
        throw new Error('unsupported');
      },
    });
    expect(await copyText('x', throwing.doc)).toBe(false);
    expect(throwing.doc.body.querySelector('textarea')).toBeNull();
  });
});
