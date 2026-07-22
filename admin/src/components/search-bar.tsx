"use client";

import { Button, Input } from "@cloudflare/kumo";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useEffect, useState, type FormEvent } from "react";

export function SearchBar({
  value,
  onSearch,
  placeholder = "搜索…",
}: {
  value: string;
  onSearch: (q: string) => void;
  placeholder?: string;
}) {
  const [q, setQ] = useState(value ?? "");
  useEffect(() => setQ(value ?? ""), [value]);

  function submit(e: FormEvent) {
    e.preventDefault();
    onSearch((q ?? "").trim());
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <div className="min-w-[240px] flex-1">
        <Input
          label="搜索"
          value={q ?? ""}
          onChange={(e) => setQ(e.target.value)}
          placeholder={placeholder}
        />
      </div>
      <Button type="submit" icon={MagnifyingGlassIcon} variant="secondary">
        查询
      </Button>
    </form>
  );
}
