import MyCodeHighlight from "../components/MyCodeHighlight";

export default async function FormsPage() {
  const data = await getData();

  return (
    <div>
      <title>{data.title}</title>
      <h1>{data.headline}</h1>
      <MyCodeHighlight />
    </div>
  );
}

const getData = async () => {
  const data = {
    title: "Ext / CodeHighlight",
    headline: "Extentions / CodeHighlight",
  };

  return data;
};