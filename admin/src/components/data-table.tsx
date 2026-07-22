"use client";

import {
  Empty,
  LayerCard,
  Loader,
  Pagination,
  Table,
  Text,
} from "@cloudflare/kumo";
import type { ReactNode } from "react";

export type Column<T> = {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
};

export function DataTable<T extends { id: string }>({
  columns,
  rows,
  loading,
  emptyTitle = "暂无数据",
  emptyDescription,
  page,
  pageSize,
  total,
  onPageChange,
}: {
  columns: Column<T>[];
  rows: T[];
  loading?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  const safeRows = rows ?? [];
  const safeTotal = Number.isFinite(total) ? total : 0;
  const safePage = Math.max(1, page || 1);
  const safePerPage = Math.max(1, pageSize || 20);

  return (
    <LayerCard>
      <LayerCard.Primary>
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12">
            <Loader />
            <Text variant="secondary">加载中…</Text>
          </div>
        ) : safeRows.length === 0 ? (
          <Empty
            size="sm"
            title={emptyTitle}
            description={emptyDescription || "没有可显示的记录"}
          />
        ) : (
          <Table>
            <Table.Header>
              <Table.Row>
                {columns.map((col) => (
                  <Table.Head key={col.key}>{col.header}</Table.Head>
                ))}
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {safeRows.map((row) => (
                <Table.Row key={row.id}>
                  {columns.map((col) => (
                    <Table.Cell key={col.key}>{col.cell(row)}</Table.Cell>
                  ))}
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        )}
      </LayerCard.Primary>
      <LayerCard.Secondary>
        <Pagination
          page={safePage}
          setPage={onPageChange}
          perPage={safePerPage}
          totalCount={safeTotal}
          controls="full"
        />
      </LayerCard.Secondary>
    </LayerCard>
  );
}
