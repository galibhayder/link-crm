import {
  cloneElement,
  forwardRef,
  Fragment,
  isValidElement,
  useId,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
} from "react";
import { cn } from "@/lib/utils";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type = "text", ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        "flex h-9 w-full rounded-md border border-line bg-surface px-3 py-1 text-sm text-foreground shadow-sm",
        "placeholder:text-muted",
        "focus-visible:border-brand-500 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring",
        "disabled:cursor-not-allowed disabled:opacity-60",
        "aria-[invalid=true]:border-danger aria-[invalid=true]:focus-visible:outline-danger",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "flex min-h-20 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-foreground shadow-sm",
        "placeholder:text-muted focus-visible:border-brand-500 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring",
        "disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn("text-[13px] font-medium leading-none text-foreground-soft", className)}
      {...props}
    />
  );
}

export function FieldError({ children }: { children?: string }) {
  if (!children) return null;
  return (
    <p role="alert" className="text-[12.5px] font-medium text-danger">
      {children}
    </p>
  );
}

/**
 * Label + control + error, so spacing is consistent across every form.
 *
 * `htmlFor` is optional: when omitted, an id is generated and injected into the
 * single child, so the label is still correctly associated.
 *
 * The id may only be injected when the child is itself the CONTROL. A child wrapped
 * in a layout element (the password field is an Input inside a div, so the
 * "Forgot password?" link can sit beside it) would otherwise receive the id on that
 * wrapper: the `<label for>` then pointed at a `<div>`, and the same id appeared
 * twice in the document. Clicking the label did nothing and assistive technology
 * announced an unlabelled field.
 *
 * So: inject into the child when it looks like a control; when it is a wrapper,
 * leave the DOM alone and pass the id down to the first child element instead. If
 * neither works the label falls back to being unassociated, which is a visible
 * problem rather than a silent one.
 */
export function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  const generated = useId();
  const id = htmlFor ?? generated;

  // A host element that is not itself a form control is a layout wrapper (the
  // password field is <div><Input/><a>Forgot?</a></div>). Injecting the id there put
  // it on a <div>: the label pointed at a div and the id appeared twice, because the
  // Input inside already had one.
  //
  // `typeof type === "string"` distinguishes a host element from a component. A
  // component is assumed to forward its props to the control, which Input and
  // Textarea both do.
  const isHostElement = isValidElement(children) && typeof children.type === "string";
  const isWrapper = isHostElement && !isFormControlTag(children.type as string);

  const resolved = isWrapper
    ? injectIdIntoFirstChild(children, id)
    : isValidElement(children)
      ? cloneElement(children as React.ReactElement<{ id?: string }>, {
          id: (children.props as { id?: string }).id ?? id,
        })
      : children;

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {resolved}
      {hint && !error && <p className="text-[12.5px] text-muted">{hint}</p>}
      <FieldError>{error}</FieldError>
    </div>
  );
}

function isFormControlTag(tag: string): boolean {
  return tag === "input" || tag === "textarea" || tag === "select";
}

/**
 * Clone a wrapper's first element child with the given id.
 *
 * Only the first child is touched, because that is the control in every layout this
 * is used for (control + trailing link). The wrapper itself gets NO id — that was
 * the duplicate.
 *
 * KEYS ARE REQUIRED HERE. `kids.map()` turns what were static JSX children into an
 * array, and React requires every element in an array to have a key. Without this,
 * every form on the site logged:
 *
 *   Warning: Each child in a list should have a unique "key" prop.
 *
 * The original children usually have no key (they are not in a list), so fall back
 * to the index. That is stable for this layout — the wrapper's children never
 * reorder; if they ever do, the key follows the original when one is present.
 */
function injectIdIntoFirstChild(node: React.ReactNode, id: string): React.ReactNode {
  if (!isValidElement(node)) return node;

  const props = node.props as { children?: React.ReactNode };
  const kids = Array.isArray(props.children) ? props.children : [props.children];
  let done = false;

  const next = kids.map((kid, index) => {
    if (!isValidElement(kid)) return kid;
    // `key` must be passed as a literal prop, never spread: React warns
    // "A props object containing a key prop is being spread into JSX".
    const key = kid.key ?? `field-child-${index}`;
    if (done) return <Fragment key={key}>{kid}</Fragment>;

    done = true;
    return cloneElement(kid as React.ReactElement<{ id?: string }>, {
      key,
      id: (kid.props as { id?: string }).id ?? id,
    });
  });

  return cloneElement(node as React.ReactElement<{ children?: React.ReactNode }>, {
    children: next,
  });
}

export function Checkbox({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="checkbox"
      className={cn(
        "size-4 rounded border-line-strong text-brand-600 accent-brand-600",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        className,
      )}
      {...props}
    />
  );
}
