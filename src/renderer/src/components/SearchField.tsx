import { Search } from "lucide-react";
import { type JSX } from "react";

import { cn } from "../lib/utils";
import { Input } from "./ui/input";

interface SearchFieldProps {
  className?: string;
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
}

export function SearchField({ className, onChange, placeholder, value }: SearchFieldProps): JSX.Element {
  return (
    <div className={cn("relative min-w-0", className)}>
      <Search
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
        size={14}
      />
      <Input
        className="pl-8 text-xs"
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
