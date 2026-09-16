/** @module features/auth/PasswordInput — 40px password field with a show/hide toggle that keeps focus in the field */
import { type ComponentProps, useState } from 'react';
import { Input } from '@/components/ui/input.tsx';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';

/** Password input. */
export function PasswordInput({
  className,
  ref,
  ...props
}: Omit<ComponentProps<'input'>, 'type' | 'size'>) {
  {
    const [visible, setVisible] = useState(false);
    const Icon = visible ? ICONS.hide : ICONS.show;
    return (
      <div className="relative">
        <Input
          ref={ref}
          type={visible ? 'text' : 'password'}
          className={cn('h-10 pr-10 font-mono', className)}
          spellCheck={false}
          autoCapitalize="off"
          {...props}
        />
        <button
          type="button"
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setVisible((v) => !v)}
          className="absolute top-1/2 right-1.5 flex size-8 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted-foreground focus-ring hover:bg-accent hover:text-foreground pointer-coarse:right-0.5 pointer-coarse:size-10"
        >
          <Icon aria-hidden="true" className="size-4" />
        </button>
      </div>
    );
  }
}
