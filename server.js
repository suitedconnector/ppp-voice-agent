import express from "express";

const app = express();

// Serve static files if you have any (optional)
// Uncomment the next line and replace 'public' with your folder
// app.use(express.static("public"));

app.get("/", (req, res) => {
  res.send("AI Studio preview is live!");
});

// Cloud Run requires process.env.PORT
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
