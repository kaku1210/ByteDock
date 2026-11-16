import { MonitorIcon } from "lucide-react";
import { useUiLanguage } from "../../i18n/useUiLanguage";
import { Menu, MenuCheckboxItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";

export function SidebarDeviceFilter({
  environments,
  hiddenIds,
  onChange,
}: {
  environments: ReadonlyMap<string, string>;
  hiddenIds: readonly string[];
  onChange: (ids: readonly string[]) => void;
}) {
  const { text } = useUiLanguage();
  const ids = [...environments.keys()];
  const allSelected = ids.every((id) => !hiddenIds.includes(id));
  return (
    <Menu>
      <MenuTrigger render={<SidebarHeaderIconButton label={text("Filter threads by device")} />}>
        <MonitorIcon className={allSelected ? "size-4" : "size-4 text-primary"} />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuCheckboxItem
          checked={allSelected}
          closeOnClick={false}
          onCheckedChange={(checked) =>
            onChange(checked ? [] : [...new Set([...hiddenIds, ...ids])])
          }
        >
          {text("All devices")}
        </MenuCheckboxItem>
        <MenuSeparator />
        {[...environments].map(([id, label]) => (
          <MenuCheckboxItem
            key={id}
            checked={!hiddenIds.includes(id)}
            closeOnClick={false}
            onCheckedChange={(checked) =>
              onChange(checked ? hiddenIds.filter((hidden) => hidden !== id) : [...hiddenIds, id])
            }
          >
            {label}
          </MenuCheckboxItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
