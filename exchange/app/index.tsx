import { Text, View } from 'react-native';

// The exchange service has no pages; this is what a browser sees at /.
export default function Index() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Text>revu's OAuth exchange. Nothing to see; the app talks to /oauth/exchange.</Text>
    </View>
  );
}
