import { SearchXIcon } from "lucide-react";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@babylonslate/ui/components/empty";

export function CatalogNoMatches({ search }: { search: string }) {
  const query = search.trim();
  return (
    <Empty className="py-12">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchXIcon />
        </EmptyMedia>
        <EmptyTitle>No Matches</EmptyTitle>
        <EmptyDescription>
          {query
            ? `Nothing matches “${query}”. Try another name or category.`
            : "This category is empty."}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
