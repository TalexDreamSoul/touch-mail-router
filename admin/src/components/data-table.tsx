"use client";

import { Empty, LayerCard, Loader, Pagination, Table, Text } from "@cloudflare/kumo";
import type { ReactNode } from "react";

export type Column<T> = {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  className?: string;
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
  return (
    <LayerCard className="overflow-hidden p-0">
      {loading ? (
        <div className="flex items-center justify-center gap-2 p-12">
          <Loader />
          <Text variant="secondary">加载中…</Text>
        </div>
      ) : rows.length === 0 ? (
        <div className="p-8">
          <Empty title={emptyTitle} description={emptyDescription} />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <Table.Header>
              <Table.Row>
                {columns.map((col) => (
                  <Table.Head key={col.key} className={col.className}>
                    {col.header}
                  </Table.Head>
                ))}
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {rows.map((row) => (
                <Table.Row key={row.id}>
                  {columns.map((col) => (
                    <Table.Cell key={col.key} className={col.className}>
                      {col.cell(row)}
                    </Table.Cell>
                  ))}
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
      )}
      <div className="border-t border-kumo-hairline px-4 py-3">
        <Pagination
          page={page}
          setPage={onPageChange}
          perPage={pageSize}
          totalCount={total}
          controls="full"
        />
      </div>
    </LayerCard>
  );
}
