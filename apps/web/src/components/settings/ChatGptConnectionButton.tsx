import { useUiLanguage } from "../../i18n/useUiLanguage";
import type { ComponentProps } from "react";
import { OpenAI } from "../Icons";
import { Button } from "../ui/button";

export function ChatGptConnectionButton({ children, ...props }: ComponentProps<typeof Button>) {
  const { text: uiText } = useUiLanguage();
  return (
    <Button {...props}>
      <OpenAI className="size-4 shrink-0" aria-hidden="true" />
      {children ?? uiText("Continue with ChatGPT")}
    </Button>
  );
}
