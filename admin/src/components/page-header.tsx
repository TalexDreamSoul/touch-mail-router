"use client";

import { Breadcrumbs } from "@cloudflare/kumo";
import type { ReactNode } from "react";
import { PageHeader as KumoPageHeader } from "@/components/kumo/page-header";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <KumoPageHeader
      breadcrumbs={
        <Breadcrumbs>
          <Breadcrumbs.Link href="/dashboard">Touch Mail</Breadcrumbs.Link>
          <Breadcrumbs.Separator />
          <Breadcrumbs.Current>{title}</Breadcrumbs.Current>
        </Breadcrumbs>
      }
      title={title}
      description={description}
    >
      {actions}
    </KumoPageHeader>
  );
}
