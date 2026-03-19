import type { Metadata } from "next";
import "@radix-ui/themes/styles.css";
import { Theme } from "@radix-ui/themes";

export const metadata: Metadata = {
  title: "Campaign Data Cleaner",
  description: "Clean and normalise CSV contact data",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>
        <Theme appearance="light" accentColor="indigo" radius="medium" scaling="100%">
          {children}
        </Theme>
      </body>
    </html>
  );
}
