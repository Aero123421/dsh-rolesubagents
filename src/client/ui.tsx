/** Small presentational pieces shared by the page and the role editor. */

import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, useId, useState } from 'react'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger'
  busy?: boolean
}

export function Button({ variant, busy, className, ...rest }: ButtonProps) {
  const classes = ['dshrs-btn', variant === undefined ? '' : `dshrs-btn--${variant}`, className ?? '']
  return <button type="button" className={classes.filter(Boolean).join(' ')} aria-busy={busy || undefined} {...rest} />
}

export function Switch(props: {
  checked: boolean
  label: string
  onChange: (checked: boolean) => void
  disabled?: boolean
  describedBy?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      className="dshrs-switch"
      aria-checked={props.checked}
      aria-label={props.label}
      aria-describedby={props.describedBy}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    />
  )
}

/**
 * A text input over a parsed draft value (a number, a list of names). The text
 * the user typed is kept while it still means the draft's value, so "30," or
 * "1." can be typed through; a value changed elsewhere (discard, reload) wins.
 */
export function TextInput({
  value,
  canonical,
  onText,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  /** The draft value as text. */
  value: string
  /** Maps typed text to the text of the value it parses to. */
  canonical: (text: string) => string
  onText: (text: string) => void
}) {
  const [typed, setTyped] = useState(value)
  const shown = canonical(typed) === value ? typed : value
  return (
    <input
      {...rest}
      value={shown}
      onChange={event => {
        setTyped(event.target.value)
        onText(event.target.value)
      }}
    />
  )
}

export function Badge(props: { tone?: 'fork' | 'ro' | 'err' | 'quiet' | 'cli'; title?: string; children: ReactNode }) {
  const tone = props.tone === undefined ? '' : ` dshrs-badge--${props.tone}`
  return (
    <span className={`dshrs-badge${tone}`} title={props.title}>
      {props.children}
    </span>
  )
}

/** What a control needs to be wired to its label, help text and error. */
export interface FieldA11y {
  id: string
  'aria-describedby': string | undefined
  'aria-invalid': true | undefined
}

/** A labelled control with optional help, character counter and error, all announced with it. */
export function Field(props: {
  label: string
  help?: string
  error?: string | undefined
  counter?: { text: string; over: boolean }
  children: (a11y: FieldA11y) => ReactNode
}) {
  const id = useId()
  const parts = [
    props.help === undefined ? '' : `${id}-help`,
    props.counter === undefined ? '' : `${id}-counter`,
    props.error === undefined ? '' : `${id}-error`,
  ].filter(Boolean)
  return (
    <div className="dshrs-field">
      <label className="dshrs-label" htmlFor={id}>
        {props.label}
      </label>
      {props.children({
        id,
        'aria-describedby': parts.length > 0 ? parts.join(' ') : undefined,
        'aria-invalid': props.error === undefined ? undefined : true,
      })}
      {props.help === undefined ? null : (
        <p className="dshrs-hint" id={`${id}-help`}>
          {props.help}
        </p>
      )}
      {props.counter === undefined ? null : (
        <p className={`dshrs-counter${props.counter.over ? ' dshrs-over' : ''}`} id={`${id}-counter`}>
          {props.counter.text}
        </p>
      )}
      {props.error === undefined ? null : (
        <p className="dshrs-error" id={`${id}-error`}>
          {props.error}
        </p>
      )}
    </div>
  )
}
