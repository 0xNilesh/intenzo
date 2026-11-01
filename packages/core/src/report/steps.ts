// Steps as people read them (§21.4's captions, §26.3's fix requests): "click: Apply",
// "fill: Discount code = \"SAVE10\"". A value typed into a field that looks secret is hidden,
// because videos and comments get shared.
import type { LoggedStep, Target } from "../schema/index.ts";

export function describeStep(step: LoggedStep): string {
  switch (step.op) {
    case "goto":
      return `goto: ${step.path}`;
    case "click":
      return `click: ${describeTarget(step.target)}`;
    case "fill":
      return `fill: ${describeTarget(step.target)} = ${typed(step.target, step.value)}`;
    case "select":
      return `select: ${describeTarget(step.target)} = ${typed(step.target, step.option)}`;
    case "press":
      return `press: ${step.key}`;
    case "scroll":
      return step.target
        ? `scroll ${step.direction}: ${describeTarget(step.target)}`
        : `scroll ${step.direction}`;
    case "wait":
      return `wait: ${step.ms} ms`;
    case "back":
      return "back";
    case "reload":
      return "reload";
  }
}

export function describeTarget(target: Target): string {
  switch (target.by) {
    case "role":
      return clip(target.name || target.role);
    case "testId":
      return clip(`testid ${target.id}`);
    case "label":
    case "placeholder":
      return clip(target.text);
    case "css":
      return clip(target.selector);
    case "point":
      return `(${Math.round(target.x)}, ${Math.round(target.y)})`;
  }
}

const SECRET_FIELD = /pass(word|code)?|secret|token|otp|\bpin\b|cvv|cvc/i;

/** What a fill or select typed, hidden when the field looks like a secret: videos get shared. */
function typed(target: Target, value: string): string {
  return SECRET_FIELD.test(describeTarget(target)) ? '"••••••"' : `"${clip(value)}"`;
}

function clip(text: string, max = 48): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
