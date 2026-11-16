import { useUiLanguage } from "../../i18n/useUiLanguage";
import { useState } from "react";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { normalizeIntervalSeconds } from "./SettingsPanels.logic";

export function IntervalSecondsField({
  label,
  value,
  min,
  step,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  step: number;
  onCommit: (seconds: number, options: { onFailed: () => void }) => void;
}) {
  const { text: uiText } = useUiLanguage();
  const [field, setField] = useState({
    saved: value,
    draft: value as number | null,
    committed: value,
    revision: 0,
  });
  if (field.saved !== value) {
    setField({ ...field, saved: value, draft: value, committed: value });
  }

  return (
    <NumberField
      value={field.draft}
      min={min}
      step={step}
      size="sm"
      className="w-32"
      onValueChange={(draft) => setField((current) => ({ ...current, draft }))}
      onValueCommitted={(next) => {
        if (next === null) {
          setField((current) => ({ ...current, draft: current.saved }));
          return;
        }
        const seconds = normalizeIntervalSeconds(next, min);
        if (seconds === field.committed) {
          setField((current) => ({ ...current, draft: seconds }));
          return;
        }
        const revision = field.revision + 1;
        setField((current) => ({ ...current, draft: seconds, committed: seconds, revision }));
        onCommit(seconds, {
          onFailed: () =>
            setField((current) =>
              current.revision !== revision
                ? current
                : {
                    ...current,
                    committed: current.saved,
                    draft: current.draft === seconds ? current.saved : current.draft,
                  },
            ),
        });
      }}
    >
      <NumberFieldGroup>
        <NumberFieldDecrement aria-label={uiText("Decrease {value0}", { value0: label })} />
        <NumberFieldInput
          aria-label={uiText("{value0}{value1} in seconds", {
            value0: label.charAt(0).toUpperCase(),
            value1: label.slice(1),
          })}
        />
        <NumberFieldIncrement aria-label={uiText("Increase {value0}", { value0: label })} />
      </NumberFieldGroup>
    </NumberField>
  );
}
