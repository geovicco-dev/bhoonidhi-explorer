import type { Metadata } from "next"
import { Fira_Code, Geist, Source_Sans_3, Figtree } from "next/font/google"

import "@workspace/ui/globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { cn } from "@workspace/ui/lib/utils";

const figtreeHeading = Figtree({subsets:['latin'],variable:'--font-heading'});

const sourceSans3 = Source_Sans_3({subsets:['latin'],variable:'--font-sans'})

// The interface's typeface; tokens.css reads it as --font-geist.
const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
})

// Every code-like element (keys, size labels, counts). tokens.css points
// Tailwind's font-mono at --font-code.
const fontMono = Fira_Code({
  subsets: ["latin"],
  variable: "--font-code",
})

export const metadata: Metadata = {
  title: "Bhoonidhi Explorer",
  description:
    "Find satellite scenes in ISRO's Bhoonidhi archive by asking in plain words or by filling in a query, see them on a map, and leave with the commands that download them.",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn("antialiased", fontMono.variable, geist.variable, "font-sans", sourceSans3.variable, figtreeHeading.variable)}
    >
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  )
}
